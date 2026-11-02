import type { GenContext } from '../context.js';
import { GenerationError } from '../types.js';
import { RuleRun, type RuleResult } from './common.js';

/** Look up an existing resource by ARN without managing it. Nothing is created or changed. */
export function emitReference(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'reference/lookup@1');
  const out = ctx.out;
  const { resource } = ctx.entry(id);
  const v = ctx.varName(id);
  const logical = ctx.str(ctx.logicalId(id));
  if (!resource.arn) {
    throw new GenerationError(
      'reference-without-arn',
      `Cannot reference ${resource.displayName}: no ARN was observed.`,
    );
  }
  const arn = ctx.str(resource.arn);

  run.header();
  switch (resource.type) {
    case 'AWS::DynamoDB::Table': {
      out.use('dynamodb');
      const stream = resource.observedProperties['latestStreamArn'];
      const streamProp = typeof stream === 'string' ? `, tableStreamArn: ${ctx.str(stream)}` : '';
      out.line(
        `const ${v} = dynamodb.Table.fromTableAttributes(this, ${logical}, { tableArn: ${arn}${streamProp} });`,
      );
      run.register('tables', v);
      break;
    }
    case 'AWS::SQS::Queue':
      out.use('sqs');
      out.line(`const ${v} = sqs.Queue.fromQueueArn(this, ${logical}, ${arn});`);
      run.register('queues', v);
      break;
    case 'AWS::Events::EventBus':
      out.use('events');
      out.line(`const ${v} = events.EventBus.fromEventBusArn(this, ${logical}, ${arn});`);
      run.register('buses', v);
      break;
    case 'AWS::S3::Bucket':
      out.use('s3');
      out.line(`const ${v} = s3.Bucket.fromBucketArn(this, ${logical}, ${arn});`);
      run.register('buckets', v);
      break;
    case 'AWS::IAM::Role':
      out.use('iam');
      out.line(`const ${v} = iam.Role.fromRoleArn(this, ${logical}, ${arn}, { mutable: false });`);
      run.register('roles', v);
      break;
    case 'AWS::Lambda::Function':
      out.use('lambda');
      out.line(`const ${v} = lambda.Function.fromFunctionArn(this, ${logical}, ${arn});`);
      run.register('functions', v);
      break;
    default:
      throw new GenerationError(
        'unsupported-reference',
        `Resource type ${resource.type} cannot be referenced.`,
      );
  }
  for (const name of Object.keys(resource.observedProperties)) {
    run.t.mark(
      name,
      'intentionally-omitted',
      'Referenced, not managed: the existing resource is looked up and left untouched.',
    );
  }
  return run.result('L2');
}
