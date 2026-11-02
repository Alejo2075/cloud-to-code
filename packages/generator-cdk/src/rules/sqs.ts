import type { GenContext } from '../context.js';
import { RuleRun, type RuleResult } from './common.js';

interface Redrive {
  deadLetterTargetArn?: string;
  maxReceiveCount?: number;
}

export function emitQueue(ctx: GenContext, id: string): RuleResult {
  const run = new RuleRun(ctx, id, 'messaging/sqs-queue@1');
  const { t } = run;
  const out = ctx.out;
  const v = ctx.varName(id);
  out.use('sqs');
  out.use('cdk');

  const props: string[] = [];
  const seconds = (name: string, prop: string) => {
    const n = t.take<number>(name);
    if (typeof n === 'number') props.push(`${prop}: cdk.Duration.seconds(${n}),`);
  };
  if (t.take<boolean>('fifoQueue')) {
    props.push('fifo: true,');
    if (t.take<boolean>('contentBasedDeduplication'))
      props.push('contentBasedDeduplication: true,');
  }
  seconds('visibilityTimeout', 'visibilityTimeout');
  seconds('messageRetentionPeriod', 'retentionPeriod');
  seconds('delaySeconds', 'deliveryDelay');
  seconds('receiveMessageWaitTimeSeconds', 'receiveMessageWaitTime');
  const maxSize = t.take<number>('maximumMessageSize');
  if (typeof maxSize === 'number') props.push(`maxMessageSizeBytes: ${maxSize},`);

  const sse = t.take<boolean>('sqsManagedSseEnabled');
  if (sse === true) props.push('encryption: sqs.QueueEncryption.SQS_MANAGED,');
  else if (sse === false) props.push('encryption: sqs.QueueEncryption.UNENCRYPTED,');
  if (t.has('kmsMasterKeyId'))
    run.unresolve(
      'kmsMasterKeyId',
      'KMS-encrypted queues are not mapped yet; configure the key manually.',
    );

  const redrive = t.take<Redrive>('redrivePolicy');
  if (redrive?.deadLetterTargetArn) {
    const dlq = ctx.resolveArn(redrive.deadLetterTargetArn);
    if (dlq) {
      props.push(
        `deadLetterQueue: { queue: ${ctx.ref(dlq)}, maxReceiveCount: ${redrive.maxReceiveCount ?? 3} },`,
      );
    } else {
      run.unresolve(
        'redrivePolicy',
        `Dead-letter queue ${redrive.deadLetterTargetArn} is not part of this plan; wire it manually.`,
      );
    }
  }
  t.omitted(
    'queueName',
    'Physical name not set so the new queue cannot collide with the existing one.',
  );
  props.push('removalPolicy: cdk.RemovalPolicy.RETAIN,');

  run.header();
  out.line(`const ${v} = new sqs.Queue(this, ${ctx.str(ctx.logicalId(id))}, {`);
  for (const p of props) out.line(`  ${p}`);
  out.line('});');
  run.tags(v);
  run.register('queues', v);
  return run.result('L2');
}

/** Redrive dependency (queue -> its DLQ) used to order declarations. */
export function queueDependency(ctx: GenContext, id: string): string | undefined {
  const redrive = ctx.entry(id).resource.observedProperties['redrivePolicy'] as Redrive | undefined;
  return ctx.resolveArn(redrive?.deadLetterTargetArn);
}
